// Airlock external effect handler: reads a Brazil order's status at
// Cloudprinter after an unsigned CloudSignal webhook nudged it.
const ERROR_STATES = new Set([7, 11, 31, 35, 39, 41]);

export async function issue(input, sink, secrets) {
  const apikey = secrets.CLOUDPRINTER_API_KEY;
  if (!apikey) throw new Error("CLOUDPRINTER_API_KEY is not set on this deployment");
  const res = await sink.fetch("/cloudcore/1.0/orders/info", {
    method: "POST",
    body: { apikey, reference: input.id },
  });
  // CloudCore answers 204 when a newly registered reference has not replicated yet.
  if (res.status !== 200) throw new Error(`Cloudprinter answered ${res.status}`);
  const order = res.body ?? {};
  if (order.reference !== input.id) {
    return { failed: { state: "mismatch", order: order.reference ?? null } };
  }
  const code = Number(order.state ?? 1);
  if (code === 500) return { failed: { state: "cancelled" } };
  if (ERROR_STATES.has(code)) {
    return { failed: { state: order.state_code ?? `error_${code}` } };
  }
  const items = Array.isArray(order.items) ? order.items : [];
  const item = items.find((i) => i?.tracking || i?.track_url) ?? items[0] ?? null;
  const trackingNumber = String(item?.tracking ?? "").trim() || null;
  const rawTrackUrl = String(item?.track_url ?? "").trim();
  const trackingUrl = rawTrackUrl || (trackingNumber ? "https://rastreamento.correios.com.br/app/index.php" : null);
  const shipped = code === 100 || code === 501 || Boolean(trackingNumber);
  const carrier = shipped || item?.shipping_level || item?.shipping_option ? "Correios SEDEX" : null;
  return {
    done: {
      state: code === 100 ? "completed" : shipped ? "shipped" : "in_progress",
      carrier,
      tracking_number: trackingNumber,
      tracking_url: trackingUrl,
    },
  };
}
