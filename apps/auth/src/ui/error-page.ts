/**
 * @fileoverview User-friendly error page renderer
 */

type ErrorLocale = 'en' | 'ar';

/** English unless the link asks for Arabic with `?lang=ar`; any other value is English. */
export function errorPageLocale(request?: Request): ErrorLocale {
	if (!request) return 'en';
	try {
		return new URL(request.url).searchParams.get('lang') === 'ar' ? 'ar' : 'en';
	} catch {
		return 'en';
	}
}

const ERROR_COPY: Record<ErrorLocale, Record<string, string>> = {
	en: {
		unavailableTitle: 'Service Temporarily Unavailable',
		unavailableMessage:
			'We are experiencing database connectivity issues. Our team has been notified and is working to resolve this.',
		errorTitle: 'Something Went Wrong',
		errorMessage: 'An unexpected error occurred. Please try again in a few moments.',
		tryAgain: 'Try Again',
		goHome: 'Go Home',
		report: 'Report this Issue',
		reference: 'Reference ID:',
		copy: 'Copy',
		copied: 'Copied!',
	},
	ar: {
		unavailableTitle: 'الخدمة غير متاحة مؤقتًا',
		unavailableMessage: 'نواجه مشكلة في الاتصال بقاعدة البيانات. تم إبلاغ فريقنا ونعمل على حلها.',
		errorTitle: 'حدث خطأ ما',
		errorMessage: 'حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى بعد قليل.',
		tryAgain: 'حاول مرة أخرى',
		goHome: 'الصفحة الرئيسية',
		report: 'الإبلاغ عن المشكلة',
		reference: 'رقم المرجع:',
		copy: 'نسخ',
		copied: 'تم النسخ!',
	},
};

/**
 * Render a user-friendly error page for server errors
 *
 * @param error - The error that occurred
 * @param requestId - Request ID for support reference
 * @param originalUrl - The original URL that caused the error (optional)
 * @param request - The request, for its `?lang=` (English unless it asks for Arabic)
 * @returns HTML response with error page
 */
export function renderErrorPage(
	error: unknown,
	requestId: string,
	originalUrl?: string,
	request?: Request
): Response {
	const locale = errorPageLocale(request);
	const t = ERROR_COPY[locale];
	const isD1Error =
		error instanceof Error &&
		(error.message.includes('D1_ERROR') ||
			error.message.includes('D1Database') ||
			error.message.includes('error code: 1031'));

	const title = isD1Error ? t.unavailableTitle : t.errorTitle;
	const message = isD1Error ? t.unavailableMessage : t.errorMessage;

	const timestamp = new Date().toISOString();
	const urlDisplay = originalUrl || 'Unknown';
	const reportSubject = encodeURIComponent(`Error Report: ${requestId}`);
	const reportBody = encodeURIComponent(`
Error Reference ID: ${requestId}
Timestamp: ${timestamp}
Error Type: ${isD1Error ? 'Database Connectivity' : 'Server Error'}
URL: ${urlDisplay}

Please describe what you were trying to do:
[Your description here]

---
Technical Details (for support team):
The error occurred while accessing the URL above.
`);

	const html = `<!DOCTYPE html>
<html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2d 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #e2e8f0;
    }
    .container {
      background: rgba(30, 41, 59, 0.9);
      border-radius: 16px;
      padding: 40px;
      max-width: 500px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.1);
    }
    .icon {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 40px;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 16px;
      color: #f8fafc;
    }
    p {
      color: #94a3b8;
      font-size: 16px;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .actions {
      display: flex;
      gap: 12px;
      justify-content: center;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .btn {
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .btn-primary {
      background: #0891b2;
      color: white;
      border: none;
    }
    .btn-primary:hover {
      background: #0e7490;
    }
    .btn-secondary {
      background: transparent;
      color: #94a3b8;
      border: 1px solid #475569;
    }
    .btn-secondary:hover {
      background: rgba(255,255,255,0.05);
      color: #e2e8f0;
    }
    .btn-report {
      background: transparent;
      color: #f59e0b;
      border: 1px solid #f59e0b;
    }
    .btn-report:hover {
      background: rgba(245, 158, 11, 0.1);
    }
    .ref {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid rgba(255,255,255,0.1);
    }
    .ref-id {
      font-size: 12px;
      color: #64748b;
      margin-bottom: 8px;
    }
    .ref-id code {
      background: rgba(0,0,0,0.3);
      padding: 4px 8px;
      border-radius: 4px;
      font-family: monospace;
      color: #94a3b8;
      user-select: all;
    }
    .copy-btn {
      background: none;
      border: none;
      color: #64748b;
      cursor: pointer;
      padding: 4px 8px;
      font-size: 12px;
      border-radius: 4px;
      margin-inline-start: 8px;
    }
    .copy-btn:hover {
      background: rgba(255,255,255,0.1);
      color: #94a3b8;
    }
    .timestamp {
      font-size: 11px;
      color: #475569;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${isD1Error ? '&#9888;' : '&#128679;'}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="actions">
      ${
			originalUrl
				? `<a href="${originalUrl.replace(/"/g, '&quot;')}" class="btn btn-primary">${t.tryAgain}</a>`
				: `<button class="btn btn-primary" onclick="window.location.reload()">${t.tryAgain}</button>`
		}
      <a href="/" class="btn btn-secondary">${t.goHome}</a>
    </div>
    <a href="mailto:support@alummahnow.net?subject=${reportSubject}&body=${reportBody}" class="btn btn-report">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
        <polyline points="22,6 12,13 2,6"></polyline>
      </svg>
      ${t.report}
    </a>
    <div class="ref">
      <div class="ref-id">
        ${t.reference} <code id="refId" dir="ltr">${requestId}</code>
        <button class="copy-btn" onclick="copyRefId()">${t.copy}</button>
      </div>
      <div class="timestamp">${timestamp}</div>
    </div>
  </div>
  <script>
    function copyRefId() {
      const refId = document.getElementById('refId').textContent;
      navigator.clipboard.writeText(refId).then(() => {
        const btn = document.querySelector('.copy-btn');
        btn.textContent = ${JSON.stringify(t.copied)};
        setTimeout(() => btn.textContent = ${JSON.stringify(t.copy)}, 2000);
      });
    }
  </script>
</body>
</html>`;

	return new Response(html, {
		status: isD1Error ? 503 : 500,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Language': locale,
			'Retry-After': '30',
		},
	});
}
