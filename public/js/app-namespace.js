/* Global namespace for the gradually-modularized mode1 / mode2 front-end.
   Feature modules attach themselves here (e.g. window.App.decor).
   Loaded before the page's main inline script. */
window.App = window.App || { modules: {} };
