// is_key — whether a keydown carried the key this arrow answers to; a chart's
// guard is a module, never a literal comparison.
({ event }, params) => event.key === params.key;
