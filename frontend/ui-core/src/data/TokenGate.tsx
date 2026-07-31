/**
 * The front door: enter a workspace token, or see the screen that asks for one.
 *
 * This is the whole of VisionSet's sign-in. There is no account, no password and
 * no session endpoint — a token is minted out of band with `visionset token create
 * --name <name>`, which prints the secret exactly once, and the browser is just
 * another client presenting it as `Authorization: Bearer`.
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
 * token" to somebody who has not started `visionset ui` sends them the wrong way
 * for ten minutes.
 */

import { KeyRound } from "lucide-react";
import { useState, type FormEvent, type JSX, type ReactNode } from "react";

import { createApiClient } from "../client";
import { Button } from "../primitives/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../primitives/Card";
import { FieldError, FieldHint, Input, Label } from "../primitives/Input";
import { useApiSession } from "./ApiProvider";
import { asApiError, NETWORK_ERROR, unwrap } from "./errors";

export interface TokenGateProps {
  /** Rendered once a credential is held. */
  readonly children: ReactNode;
}

/**
 * Show `children` when there is a token, and the form when there is not.
 *
 * A 401 anywhere in the app clears the session (`ApiProvider`), so this component
 * is also the "your token was revoked while you were working" screen — without
 * knowing anything about that, which is the point of handling the 401 in one
 * place.
 */
export function TokenGate({ children }: TokenGateProps): JSX.Element {
  const { token } = useApiSession();
  if (token === null) return <TokenForm />;
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
      // `docs/api.md` gives paging parameters to exactly one collection, the batch
      // asset listing, and this one does not have them.
      unwrap(await probe.GET("/projects", {}));
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
            <KeyRound className="size-4 text-primary" aria-hidden="true" />
            Connect to a workspace
          </CardTitle>
          <CardDescription>
            VisionSet has no accounts. Paste an API token for the workspace this server is
            serving.
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
    return "No answer from the server. Is `visionset ui` running?";
  }
  return `${failure.code}: ${failure.message}`;
}
