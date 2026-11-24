// The app is served from snapcards.fun alone; its other addresses keep their links working there.
export default {
	fetch(request) {
		const { pathname, search } = new URL(request.url);
		return Response.redirect(`https://snapcards.fun${pathname}${search}`, 301);
	},
};
