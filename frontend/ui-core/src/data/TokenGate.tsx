/**
 * The front door — which, on your own machine, you never see.
 *
 * There is no account and no password. There are two credentials, and the gate's
 * whole job is to notice which one applies before showing anybody a form.
 *
 * **A browser session.** The server signs in the page it served itself, over an
 * `HttpOnly` cookie. Opening `visionset server` on the machine it runs on
 * reaches the product with nothing typed and nothing copied, because asking
 * somebody to paste a credential to read their own files off their own disk is
 * ceremony with no threat model behind it. This component is what asks — once, on
 * mount, through `ensureAccess` — and until the answer arrives it renders nothing,
 * which is the difference between a gate and a flash of a login form. Asking from
 * here rather than from the provider is also what keeps the two ungated routes
 * from making a request they have no server for.
 *
 * **A token**, minted out of band with `visionset token create --name <name>`,
 * which prints the secret exactly once, and presented as `Authorization: Bearer`
 * like any other client. It is what a third-party program uses, and it is what a
 * browser uses when the server will not sign it in by itself — a LAN client of a
 * `--host 0.0.0.0` server, or a deployment that has turned sessions off. The form
 * below is for that case, and only for it.
 *
 * ## The token is verified before it is adopted
 *
 * Storing whatever was pasted and letting the first screen fail would be simpler
 * and is wrong: the failure lands on a project list, which then shows an error
 * about projects when the real problem is the credential. So the form spends one
 * request — `GET /projects`, the cheapest authenticated route the contract has —
 * and only calls `signIn` when it comes back 200.
 *
 * The request is made with a **throwaway client** rather than through the session,
 * because adopting the credential is precisely what is being decided. That also
 * keeps the query cache clean: a rejected token never lands an entry in it.
 *
 * ## Every refusal reads the same, because the API means it to
 *
 * The API answers one identical 401 for a missing, malformed, unknown or revoked
 * token — a body that distinguished them would be an oracle for which credentials
 * exist. The form does not try to be more helpful than the contract allows: one
 * sentence, and a pointer at the command that mints one. The *other* failures are
 * worth telling apart, and are: a server that is not running (`NETWORK_ERROR`) is
 * the most likely failure of all on a local-first tool, and saying "check the
 * token" to somebody who has not started `visionset server` sends them the wrong way
 * for ten minutes.
 */

import { Key } from "lucide-react";
import { useEffect, useState, type FormEvent, type JSX, type ReactNode } from "react";

import { createApiClient } from "../client";
import { Button } from "../primitives/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../primitives/Card";
import { FieldError, FieldHint, Input, Label } from "../primitives/Input";
import { useApiSession } from "./ApiProvider";
import { refusalProse } from "./refusals";
import { asApiError, NETWORK_ERROR, unwrap } from "./errors";
import { checkListProjects } from "../generated/checks";

export interface TokenGateProps {
  /** Rendered once a credential is held. */
  readonly children: ReactNode;
}

/**
 * Show `children` once a credential is held, and the form when none is.
 *
 * A 401 anywhere in the app clears the session (`ApiProvider`), so this component
 * is also the "your token was revoked while you were working" screen — without
 * knowing anything about that, which is the point of handling the 401 in one
 * place.
 *
 * `checking` renders **nothing**, deliberately. It lasts one request against a
 * server on the same machine, and a spinner that appears and vanishes inside a
 * frame is worse than a frame of nothing — while showing the *form* during it
 * would put a login screen in front of the one user who never has to see one.
 */
export function TokenGate({ children }: TokenGateProps): JSX.Element {
  const { access, ensureAccess } = useApiSession();
  // Asked from here rather than on the provider's mount, so that the two routes
  // deliberately outside this gate issue no request at all — they have no server
  // to authenticate against, and on a page with no API behind it a failed probe
  // is a console error `demo.spec.ts` is right to fail on.
  useEffect(ensureAccess, [ensureAccess]);
  if (access === "checking") return <></>;
  if (access === "none") return <TokenForm />;
  return <>{children}</>;
}

export function TokenForm(): JSX.Element {
  const { baseUrl, signIn } = useApiSession();
  const [value, setValue] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const candidate = value.trim();
    if (candidate === "") return;

    setChecking(true);
    setFailure(null);
    try {
      const probe = createApiClient({ baseUrl, token: candidate });
      // The cheapest authenticated route in the contract. The answer is thrown
      // away — only its status is the question. There is deliberately no `limit`:
      // `docs/content/api.md` gives paging parameters to exactly one collection, the batch
      // asset listing, and this one does not have them.
      // Checked like every other read, even though the answer is discarded: a server
      // that cannot answer `/projects` in the contract's shape is not one to sign into,
      // and an exemption here would be a hole the wiring gate has to allowlist forever.
      unwrap(await probe.GET("/projects", {}), checkListProjects);
      signIn(candidate);
    } catch (cause) {
      setFailure(refusalOf(cause));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="size-4 text-primary" aria-hidden="true" />
            Connect to a workspace
          </CardTitle>
          <CardDescription>
            VisionSet has no accounts. This server did not sign this browser in by itself —
            because it is not the machine the server runs on, or because sessions are off — so
            paste an API token for the workspace it is serving.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="visionset-token">API token</Label>
              <Input
                id="visionset-token"
                data-testid="token-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="paste the secret printed by visionset token create"
              />
              <FieldHint>
                Mint one with <code className="font-mono">visionset token create --name ui</code>.
                It is shown exactly once. Kept for this browser tab only.
              </FieldHint>
              {failure !== null && <FieldError data-testid="token-error">{failure}</FieldError>}
            </div>
            <Button
              type="submit"
              variant="primary"
              data-testid="token-submit"
              disabled={checking || value.trim() === ""}
            >
              {checking ? "Checking…" : "Connect"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * What to tell somebody whose token did not work.
 *
 * Three cases, and the split is by **what they should do next** rather than by
 * status — the same rule `MediaError` follows in the kernel.
 */
function refusalOf(cause: unknown): string {
  const failure = asApiError(cause);
  if (failure.isUnauthorized) {
    return "That token was refused. It may be mistyped, revoked, or minted for a different workspace.";
  }
  if (failure.code === NETWORK_ERROR) {
    return "No answer from the server. Is `visionset server` running?";
  }
  // Everything else through the shared vocabulary. The two branches above stay
  // local because they are about *this* screen — a token being refused and a
  // server not answering are the sign-in screen's own two failures, and the
  // generic sentences would be worse. That is the same division the approve
  // dialog makes: one vocabulary, and a screen may say something more specific
  // where it genuinely knows more.
  return refusalProse(cause);
}
