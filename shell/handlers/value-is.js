({ event }, params) => String(event.value ?? "").trim().toLowerCase() === params.value
