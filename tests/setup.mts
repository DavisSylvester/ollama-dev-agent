import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Preloaded before every test file (bunfig.toml). Values set here count as the
// real environment, so they win over oda's own .env (see selectOdaEnv):
// - logs go to a temp file, never the real .oda.log used to diagnose runs;
// - model settings are fixed, so tests don't depend on whatever the
//   developer's .env configures;
// - the model endpoint is unreachable and there is no API key, so no test can
//   reach a real (possibly paid) provider by accident.
// ODA_LIVE_TESTS=1 opts in to the tests that call a real model, using the
// configured .env models and key.
process.env['LOG_FILE'] = join(tmpdir(), `oda-test-${process.pid}.log`);
if (!process.env['ODA_LIVE_TESTS']) isolateFromRealModels();

function isolateFromRealModels(): void {
  process.env['OLLAMA_BASE_URL'] = 'http://127.0.0.1:9';
  process.env['OLLAMA_API_KEY'] = '';
  process.env['PLANNER_MODEL'] = 'test-planner';
  process.env['CODER_MODEL'] = 'test-coder';
  process.env['EDITOR_MODEL'] = 'test-editor';
}
