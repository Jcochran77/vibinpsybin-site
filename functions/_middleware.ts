// Block known vulnerability-scanner probe paths early at the edge.
//
// CONTEXT (Joe + Cortana, 2026-06-17):
// CF analytics showed thousands of bot requests/day hitting paths like
//   /cron/.env, /administrator/.env, /wp-admin/install.php, /phpinfo.php,
// most returning HTTP 200 because the Functions/SPA catch-all happily
// served them HTML. The bots got nothing useful, but the inflated
// request count was masking real traffic in the dashboard.
//
// This middleware short-circuits those paths with HTTP 410 Gone (the
// "this resource is permanently and intentionally not here" status).
// 410 is cheaper than serving HTML and signals to well-behaved scanners
// to stop retrying. Bad actors will keep trying anyway — that's life on
// the public internet — but at least our metrics stay honest.

const BLOCK_PATTERNS: RegExp[] = [
  // Dotenv / config-leak probes
  /\/\.env(\.|$|\/)/i,
  /\/\.git(\/|$)/i,
  /\/\.aws(\/|$)/i,
  /\/\.ssh(\/|$)/i,
  /\/\.htaccess$/i,
  /\/config\.(php|json|yml|yaml)$/i,

  // PHP-app probes (we don't run PHP)
  /\.php($|\?)/i,
  /\/phpinfo/i,
  /\/phpmyadmin/i,
  /\/pma\//i,

  // WordPress probes (we're not WordPress)
  /\/wp-(admin|login|content|includes|json)/i,
  /\/wordpress\//i,
  /\/xmlrpc\.php/i,

  // Generic admin / CMS probes (Joomla, Magento, Yii, etc.)
  /\/administrator\//i,
  /\/admin\/(login|config|setup|install)/i,
  /\/joomla\//i,
  /\/magento\//i,
  /\/yii\//i,
  /\/laravel\//i,
  /\/gitlab\//i,
  /\/jenkins\//i,
  /\/owa\//i,

  // Backup / dev-leak probes
  /\.(bak|old|backup|sql|sql\.gz|zip|tar\.gz|rar|swp)$/i,
  /\/backup(s)?\//i,
  /\/dump(s)?\//i,
  /\/dist\.(zip|tar\.gz)$/i,

  // Misc shell / debug probes
  /\/debug\.(php|json)$/i,
  /\/server-status$/i,
  /\/actuator(\/|$)/i,
  /\/console\/login$/i,
  /\/api\/v[0-9]+\/\.env/i,
];

// Note: we build the Response inside the handler, not at module scope.
// Cloudflare Workers disallows I/O-ish operations (including Response
// constructor with a body) during global init.
function goneResponse(): Response {
  return new Response("Gone.\n", {
    status: 410,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export const onRequest: PagesFunction = async (ctx) => {
  const path = new URL(ctx.request.url).pathname;
  for (const re of BLOCK_PATTERNS) {
    if (re.test(path)) {
      return goneResponse();
    }
  }
  return ctx.next();
};
