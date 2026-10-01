// Stands in for carecontinuity.app's launcher host so integration tests drive the mock protocol host.
import { createMockLauncherHost } from '@cc-dayers/portal-protocol/mock-host';

process.exitCode = await createMockLauncherHost({ args: process.argv.slice(2) }).done;
