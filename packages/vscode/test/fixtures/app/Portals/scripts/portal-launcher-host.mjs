// Stands in for carecontinuity.app's launcher host so integration tests drive the mock protocol host.
import { runMockLauncherHost } from '@cc-dayers/portal-protocol/mock-host';

process.exitCode = await runMockLauncherHost();
