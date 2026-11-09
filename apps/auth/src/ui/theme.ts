/**
 * The sign-in pages' OpenAuth theme.
 *
 * It must not depend on the request. OpenAuth stores the theme in a global
 * (globalThis.OPENAUTH_THEME, via setTheme) that every request in the isolate
 * shares, and renders after async work. A per-request theme (locale/direction
 * from ?lang=) let a concurrent English request overwrite an Arabic one's, so
 * Arabic pages came out as <html lang="ar" dir="ltr"> under load.
 *
 * So there is no `locale` or `direction` here: OpenAuth's Layout derives the
 * direction from the request's own locale (theme.direction would override it),
 * and the Arabic title font is chosen in CSS with :lang(ar).
 */

export const BACKGROUND_IMAGES = [
	'https://images.alummahnow.net/background_1.jpg',
	'https://images.alummahnow.net/background_3.jpg',
] as const;

export function authTheme(backgroundImage: string) {
	return {
		title: {
			en: 'Al Ummah Now',
			ar: 'الأمة الآن',
		},
		primary: {
			light: '#d4930d', // Warm amber gold on light mode
			dark: '#f5b014', // Warm golden on dark mode
		},
		background: {
			light: '#1a1a1a',
			dark: '#0c0a09',
		},
		favicon: 'https://al-ummah-now-images.b-cdn.net/favicon_io/favicon.ico',
		logo: {
			dark: 'https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png',
			light: 'https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png',
		},
		radius: 'md' as const,
		font: {
			family: 'Cairo, sans-serif',
		},
		css: `
            @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700&display=swap');

            @font-face {
              font-family: 'Farsi Simple Bold';
              src: url('https://cdn.alummahnow.net/fonts/Farsi%20Simple%20Bold%20Regular.ttf') format('truetype');
              font-display: swap;
            }

            [data-component="root"] {
              background-image: url('${backgroundImage}');
              background-size: cover;
              background-position: center;
              background-repeat: no-repeat;
            }

            [data-component="center"] {
              background: rgba(0, 0, 0, 0.4);
              padding: 2rem;
              border-radius: 1rem;
              backdrop-filter: blur(10px);
            }

            /* Golden halo around logo */
            [data-component="logo"] {
              filter: drop-shadow(0 0 15px rgba(245, 176, 20, 0.6)) drop-shadow(0 0 30px rgba(245, 176, 20, 0.3));
            }

            [data-component="title"] {
              font-family: Cairo, sans-serif;
            }

            /* Farsi font for the Arabic title */
            :lang(ar) [data-component="title"] {
              font-family: "Farsi Simple Bold";
            }
          `,
	};
}

/** One theme per isolate: the background is picked once, not per request. */
export const AUTH_THEME = authTheme(BACKGROUND_IMAGES[Math.floor(Math.random() * BACKGROUND_IMAGES.length)]);
