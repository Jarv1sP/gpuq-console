// Explicit frontend-only additions shared by the demo and the production portal.
// Keep static asset registration separate from every API and execution route.
export const STARBASE_ASSETS = Object.fromEntries([
  'fonts.css', 'starbase.css', 'shell.css', 'workbench.css', 'terminal.css', 'resources.css', 'apple-touch-icon.png', 'members.css', 'copy-help.css',
  'shell-ui.js', 'control-ui.js', 'attention-state.js', 'workbench-ui.js', 'motion-ui.js', 'copy-help-ui.js', 'auth-ui.js', 'navigation.js',
  'favicon.svg', 'favicon.ico', 'mask-icon.svg',
  'dataset-remove-ui.js', 'dataset-remove.css',
  'dataset-full-delete-ui.js', 'dataset-full-delete-state.js',
  'upload-routes.js',
  'dataset-catalog-model.js', 'dataset-label-client.js', 'dataset-warehouse-view.js', 'dataset-warehouse.css', 'dataset-upload-metrics.js',
  'admin-data-storage.js', 'admin-data-storage.css',
  'dataset-flow.js', 'dataset-cache-admin.js', 'manual-pin-state.js', 'dataset-flow.css',
  'maintenance-state.js', 'maintenance-experience.js', 'maintenance-experience.css',
  'admin-ui.js', 'admin.css',
  'vendor/fonts/Archivo-Variable.woff2',
  'vendor/fonts/Geist-Variable.woff2',
  'vendor/fonts/GeistMono-Variable.woff2',
].map(file => ['/' + file, file]));
