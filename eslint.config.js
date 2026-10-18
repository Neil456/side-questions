const browser = Object.fromEntries(
  [
    'window', 'document', 'location', 'history', 'navigator', 'console', 'crypto', 'localStorage', 'getSelection',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'fetch', 'URL',
    'Node', 'NodeFilter', 'MutationObserver', 'DOMParser', 'DataTransfer', 'Event', 'MouseEvent', 'PointerEvent',
    'KeyboardEvent', 'ClipboardEvent', 'HTMLTextAreaElement', 'CSS', 'Highlight', 'chrome', 'globalThis',
  ].map((g) => [g, 'readonly']),
);

export default [
  {
    files: ['src/**/*.js', 'tests/mock/*.js'],
    languageOptions: { sourceType: 'script', globals: browser },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }], 'no-undef': 'error' },
  },
  {
    files: ['tests/*.mjs', 'eslint.config.js'],
    languageOptions: { sourceType: 'module', globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } },
  },
  {
    files: ['tests/e2e.mjs'],
    languageOptions: {
      globals: { document: 'readonly', getSelection: 'readonly', NodeFilter: 'readonly', MouseEvent: 'readonly', localStorage: 'readonly', CSS: 'readonly' },
    },
  },
];
