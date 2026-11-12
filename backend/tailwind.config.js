'use strict';

module.exports = {
  content: [
    '../frontend/index.html',
    '../frontend/app.js',
  ],
  safelist: [
    'active',
    'selected',
    'open',
    'show',
    'error',
    'success',
    'status-active',
    'status-pending',
    'status-rejected',
    'status-paused',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Vazirmatn', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        cinematic: {
          black: '#000000',
          surface: '#121214',
          crimson: '#E50914',
          violet: '#9333EA',
          amber: '#FFB800',
        },
      },
    },
  },
  plugins: [],
};
