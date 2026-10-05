// Explicit frontend-only additions shared by the demo and the production portal.
// Keep static asset registration separate from every API and execution route.
export const STARBASE_ASSETS = Object.fromEntries([
  'fonts.css', 'starbase.css', 'shell.css', 'workbench.css', 'terminal.css', 'resources.css', 'apple-touch-icon.png', 'members.css', 'copy-help.css',
  'shell-ui.js', 'control-ui.js', 'workbench-ui.js', 'motion-ui.js', 'copy-help-ui.js', 'auth-ui.js', 'navigation.js',
  'favicon.svg', 'favicon.ico', 'mask-icon.svg',
  'dataset-flow.js', 'dataset-cache-admin.js', 'dataset-flow.css',
  'maintenance-state.js', 'maintenance-experience.js', 'maintenance-experience.css',
  'vendor/fonts/Archivo-Variable.woff2',
  'vendor/fonts/Geist-Variable.woff2',
  'vendor/fonts/GeistMono-Variable.woff2',
].map(file => ['/' + file, file]));
