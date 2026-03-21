/**
 * Extends the test harness with the worker env bindings declared by the app.
 */
declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}
