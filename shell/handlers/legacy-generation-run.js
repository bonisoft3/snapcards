({ context, event }) => !context.items[0]?.run && /^run-[1-9][0-9]*$/.test(String(event.value ?? ""))
