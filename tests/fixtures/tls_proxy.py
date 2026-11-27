# usage: from tests.fixtures.tls_proxy import Credentials, make_pki, serving_proxy
"""An authenticating TLS reverse proxy, and a throwaway certificate authority for it.

Stands in front of a real tracking server the way a remote deployment does: HTTPS
with a certificate no public bundle trusts, and an ``Authorization`` header checked
before anything is forwarded. Every key and certificate is generated at test time
into a directory the caller owns, and nothing is written anywhere else.
"""

from __future__ import annotations

import datetime
import http.client
import ipaddress
import ssl
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

_HOP_BY_HOP = frozenset(
    {"connection", "keep-alive", "transfer-encoding", "host", "authorization", "content-length"}
)


@dataclass(frozen=True)
class Pki:
    ca: Path
    server_cert: Path
    server_key: Path
    client_bundle: Path
    """The client certificate and its key in one PEM, the form MLflow's
    ``MLFLOW_TRACKING_CLIENT_CERT_PATH`` hands to ``requests``."""


def _key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def _pem(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )


def _issue(
    subject: str,
    key: ec.EllipticCurvePrivateKey,
    issuer: x509.Certificate | None = None,
    issuer_key: ec.EllipticCurvePrivateKey | None = None,
    *,
    usage: x509.ObjectIdentifier | None = None,
) -> x509.Certificate:
    """A CA when ``usage`` is None, else a leaf ``issuer`` signs. Carries the key
    identifiers and key usage that strict X.509 verification (Python 3.13+) requires."""
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subject)])
    now = datetime.datetime.now(datetime.UTC)
    is_ca = usage is None
    signer = issuer_key or key
    builder = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(issuer.subject if issuer else name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(hours=1))
        .add_extension(x509.BasicConstraints(ca=is_ca, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=is_ca,
                crl_sign=is_ca,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(signer.public_key()),
            critical=False,
        )
    )
    if usage is not None:
        builder = builder.add_extension(x509.ExtendedKeyUsage([usage]), critical=False)
    if usage == ExtendedKeyUsageOID.SERVER_AUTH:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            critical=False,
        )
    return builder.sign(signer, hashes.SHA256())


def make_pki(directory: Path) -> Pki:
    ca_key, server_key, client_key = _key(), _key(), _key()
    ca = _issue("visionset test CA", ca_key)
    server = _issue("127.0.0.1", server_key, ca, ca_key, usage=ExtendedKeyUsageOID.SERVER_AUTH)
    client = _issue(
        "visionset test client", client_key, ca, ca_key, usage=ExtendedKeyUsageOID.CLIENT_AUTH
    )
    pki = Pki(
        ca=directory / "ca.pem",
        server_cert=directory / "server.pem",
        server_key=directory / "server.key",
        client_bundle=directory / "client.pem",
    )
    pki.ca.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    pki.server_cert.write_bytes(server.public_bytes(serialization.Encoding.PEM))
    pki.server_key.write_bytes(_pem(server_key))
    pki.client_bundle.write_bytes(
        client.public_bytes(serialization.Encoding.PEM) + _pem(client_key)
    )
    return pki


@dataclass
class Proxy:
    url: str = ""
    authorizations: list[str | None] = field(default_factory=list)
    refused: int = 0


@contextmanager
def serving_proxy(
    upstream: str, pki: Pki, *, accept: str, require_client_cert: bool = False
) -> Iterator[Proxy]:
    """Forward to ``upstream`` only what carries ``Authorization: <accept>``; 401 the rest."""
    state = Proxy()
    target = urlsplit(upstream)
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:
            pass

        def _forward(self) -> None:
            authorization = self.headers.get("Authorization")
            with lock:
                state.authorizations.append(authorization)
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else None
            if authorization != accept:
                with lock:
                    state.refused += 1
                self.send_response(401)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            headers = {
                key: value for key, value in self.headers.items() if key.lower() not in _HOP_BY_HOP
            }
            connection = http.client.HTTPConnection(target.netloc, timeout=30)
            try:
                connection.request(self.command, self.path, body=body, headers=headers)
                answer = connection.getresponse()
                payload = answer.read()
            finally:
                connection.close()
            self.send_response(answer.status)
            self.send_header("Content-Type", answer.getheader("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_PATCH = do_DELETE = _forward

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(pki.server_cert, pki.server_key)
    if require_client_cert:
        context.verify_mode = ssl.CERT_REQUIRED
        context.load_verify_locations(pki.ca)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    state.url = f"https://127.0.0.1:{server.server_port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
