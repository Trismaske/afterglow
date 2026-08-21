import { registerRootComponent } from 'expo';

import { initDiagLog } from './src/lib/diagLog';
import App from './App';

// FIRST, before anything can log or crash: hook console + the global
// error handler into the on-device diagnostics sink (m0.8.7). A build
// without the native module makes this a no-op.
initDiagLog();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
