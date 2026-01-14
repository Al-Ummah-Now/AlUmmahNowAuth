import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { useEffect, useState } from "react";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const email = url.searchParams.get("email") || "Unknown";
  const redirectUrl = url.searchParams.get("redirect") || "/login";

  return { email, redirectUrl };
}

export default function Forbidden() {
  const { email, redirectUrl } = useLoaderData<typeof loader>();
  const [countdown, setCountdown] = useState(3);

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          window.location.href = redirectUrl;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [redirectUrl]);

  return (
    <div className="min-h-screen bg-[#0f172a] flex items-center justify-center p-5 text-[#e2e8f0]">
      <div className="bg-[#1e293b] rounded-xl p-8 max-w-[400px] w-full text-center shadow-lg">
        <div className="w-16 h-16 bg-red-500 rounded-full flex items-center justify-center mx-auto mb-5 text-3xl">
          &#128274;
        </div>
        <h1 className="text-2xl font-semibold mb-3 text-[#f8fafc]">Access Denied</h1>
        <p className="text-[#94a3b8] text-sm mb-4">Signed in as: {email}</p>
        <p className="text-[#94a3b8] text-sm leading-relaxed mb-5">
          This account does not have administrator privileges. Please sign in with an admin account to access the dashboard.
        </p>
        <p className="text-[#64748b] text-xs">
          Redirecting to account selection in <span className="text-blue-500 font-semibold">{countdown}</span> seconds...
        </p>
      </div>
    </div>
  );
}
