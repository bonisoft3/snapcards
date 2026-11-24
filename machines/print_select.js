({ context, event }, { machine }) => {
  if (event.type !== "click") return { updates: [] };
  const fromMap = {
    "btn-top-print": "69618be6-9206-f9c7-59eb-b5e4b072cf3d"
  };
  const firstItem = context.items?.[0];
  const fallbackId = firstItem?.set_id || (firstItem?.id !== "session" && firstItem?.id !== "config" ? firstItem?.id : undefined);
  const id =
    event.id ??
    event.target?.dataset?.id ??
    event.target?.closest?.("[data-id]")?.dataset?.id ??
    (event.from ? fromMap[event.from] : undefined) ??
    fallbackId;
  if (!id) return { updates: [] };
  machine.execute({ initialize: true, payload: {}, context: { tier: "mecha" }, viewers: [] });
  const updates = [{
    op: "patch",
    entity: "print_config",
    id: "config",
    row: { set_id: id }
  }];
  return { updates };
}
