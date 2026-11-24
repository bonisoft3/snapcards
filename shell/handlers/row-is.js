({ context }, params) => Object.entries(params).every(([column, value]) => String(context.items[0]?.[column] ?? "") === value)
