export function currencyScale(currency: string): number {
	// Stripe keeps ISK/UGX amounts in hundredths despite their ISO exponent.
	if (["isk", "ugx"].includes(currency.toLowerCase())) return 100;
	const digits = new Intl.NumberFormat("en", { style: "currency", currency })
		.resolvedOptions().maximumFractionDigits;
	return 10 ** (digits ?? 2);
}
