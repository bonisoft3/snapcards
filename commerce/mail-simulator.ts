// Cloudflare's Email Sending API for the compose stack: what the confirm, record
// and alert effects post in production, handed to Mailpit, whose inbox acceptance reads.
const SEND = /^\/client\/v4\/accounts\/[^/]+\/email\/sending\/send$/;

export function createMailSimulator(options: { mailpit: string; fetch?: typeof fetch }) {
	const send = options.fetch ?? fetch;
	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/_simulator/health") {
			return Response.json({ status: "ok" });
		}
		if (req.method !== "POST" || !SEND.test(url.pathname)) {
			return Response.json({ success: false, errors: [{ code: 7003, message: "No route" }] }, { status: 404 });
		}
		if (!req.headers.get("Authorization")?.startsWith("Bearer ")) {
			return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 401 });
		}
		const { from, to, subject, text, headers, attachments = [] } = await req.json();
		const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
		const inbox = await send(`${options.mailpit}/api/v1/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				From: { Email: from },
				To: recipients.map((email: string) => ({ Email: email })),
				Subject: subject,
				Text: text,
				...(headers && Object.keys(headers).length ? { Headers: headers } : {}),
				Attachments: attachments.map((a: { content: string; filename: string; type: string }) => ({ Content: a.content, Filename: a.filename, ContentType: a.type })),
			}),
		});
		if (!inbox.ok) throw new Error(`Mailpit answered ${inbox.status}: ${await inbox.text()}`);
		const { ID } = await inbox.json();
		const host = String(from ?? "").split("@")[1] || "snapcards.test";
		return Response.json({ success: true, errors: [], result: { delivered: recipients, message_id: `<${ID}@${host}>` } });
	};
}

if (import.meta.main) {
	const mailpit = Deno.env.get("MAILPIT_URL");
	if (!mailpit) throw new Error("Missing simulator setting: MAILPIT_URL");
	Deno.serve(
		{
			hostname: Deno.env.get("SAYT_PLATFORM") === "host" ? "127.0.0.1" : "0.0.0.0",
			port: Number(Deno.env.get("PORT") ?? "8080"),
		},
		createMailSimulator({ mailpit }),
	);
}
