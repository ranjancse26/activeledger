function guardedConsole(method) {
  /* istanbul ignore else */
  // if (typeof console !== 'undefined' && typeof console[method] === 'function') {
  //   var args = Array.prototype.slice.call(arguments, 1);
  //   console[method].apply(console, args);
  // }
  // Skip Console Logs (Handled elsewhere)
}

export default guardedConsole;
