/** Playwright global setup: start this invocation with an empty run-account registry. */
import { clearRunAccounts } from './utils/run-accounts';

export default function globalSetup(): void {
  clearRunAccounts();
}
