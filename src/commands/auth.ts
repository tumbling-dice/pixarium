import { runPiAuthentication } from "../pi-runner.js";

/** bundled PiのOAuth認証フローを、Pixarium CLIのauth commandとして起動する。 */
export async function authenticatePi(): Promise<void> {
  await runPiAuthentication();
}
