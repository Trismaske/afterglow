import type { ComponentType } from 'react';
import { registerRootComponent } from 'expo';

import { initDiagLog } from './src/lib/diagLog';

// FIRST, before anything can log or crash: hook console + the global
// error handler into the on-device diagnostics sink (m0.8.7). A build
// without the native module makes this a no-op.
//
// The App import is DEFERRED (codex m0.8.7 r1): a static `import App`
// hoists above this call, so the whole application module graph would
// evaluate — and could log or crash — before the hook exists. require()
// keeps the evaluation order the comment promises.
initDiagLog();

const App = require('./App').default as ComponentType;

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
