<?php
/**
 * Diffract — workspace availability proxy (Hostinger shared LiteSpeed / PHP).
 *
 * Same-origin endpoint the signup page calls to check a subdomain BEFORE paying.
 * It forwards to the control plane's /api/available so the control-plane host
 * (cp.diffraction.in) and CORS never have to be exposed to the browser. The
 * control-plane base URL is read from the same .diffract-dodo.env file as the
 * Dodo key (key: CONTROL_PLANE_BASE), one level above public_html.
 *
 * GET /api/available.php?subdomain=acme  ->  {"available":true|false,"reason":"..."}
 * Fail-open: if the control plane is unset/unreachable we return available:true
 * with a note, so signup never hard-blocks on it (the provisioner is the final
 * arbiter at webhook time).
 */

header('Content-Type: application/json');
header('Cache-Control: no-store');

function env_value($key) {
  $env = getenv($key);
  if ($env) return trim($env);
  $candidates = [
    __DIR__ . '/../../.diffract-dodo.env',
    __DIR__ . '/../.diffract-dodo.env',
    __DIR__ . '/.diffract-dodo.env',
  ];
  $prefix = $key . '=';
  $plen = strlen($prefix);
  foreach ($candidates as $p) {
    if (is_readable($p)) {
      foreach (file($p, FILE_IGNORE_NEW_LINES) as $line) {
        $line = trim($line);
        if (strncmp($line, $prefix, $plen) === 0) {
          $v = trim(substr($line, $plen));
          if ($v !== '') return $v;
        }
      }
    }
  }
  return null;
}

$sub = strtolower(trim($_GET['subdomain'] ?? ''));
// Mirror the control plane's validation so obviously-bad names fail fast here.
if ($sub === '' || !preg_match('/^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])$/', $sub)) {
  echo json_encode(['available' => false, 'reason' => 'invalid name']);
  exit;
}

$base = env_value('CONTROL_PLANE_BASE');
if (!$base) {
  echo json_encode(['available' => true, 'reason' => 'control plane not configured (provisional)']);
  exit;
}

$url = rtrim($base, '/') . '/api/available?subdomain=' . rawurlencode($sub);
$out = false;
if (function_exists('curl_init')) {
  $ch = curl_init($url);
  curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 6]);
  $out = curl_exec($ch);
  curl_close($ch);
} else {
  $ctx = stream_context_create(['http' => ['method' => 'GET', 'timeout' => 6, 'ignore_errors' => true]]);
  $out = @file_get_contents($url, false, $ctx);
}

if ($out === false) {
  echo json_encode(['available' => true, 'reason' => 'unreachable (provisional)']);
  exit;
}

$j = json_decode($out, true);
if (!is_array($j) || !array_key_exists('available', $j)) {
  echo json_encode(['available' => true, 'reason' => 'unknown (provisional)']);
  exit;
}
echo json_encode(['available' => (bool)$j['available'], 'reason' => $j['reason'] ?? '']);
