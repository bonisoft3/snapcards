({ event }, params) => event.key === params.key && !event.modified && String(event.value ?? "").trim() === params.value
