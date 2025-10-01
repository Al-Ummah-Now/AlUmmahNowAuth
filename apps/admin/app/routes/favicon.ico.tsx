import type { LoaderFunctionArgs } from "react-router";

export async function loader({ request }: LoaderFunctionArgs) {
  // Redirect to the actual favicon hosted on CDN
  return Response.redirect(
    "https://al-ummah-now-images.b-cdn.net/favicon_io/favicon.ico",
    301
  );
}
