/* global __APP_BUILD__ */
export const APP_BUILD = typeof __APP_BUILD__ === 'undefined' ? {commit: 'unknown', builtAt: null} : __APP_BUILD__
