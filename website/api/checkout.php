<?php
/**
 * Diffract — Dodo Payments checkout endpoint (Hostinger shared LiteSpeed / PHP).
 *
 * The PHP port of website/local-dev-server.py's /api/checkout. The signup page
 * POSTs {workspace,email,name}; this creates a Dodo hosted-checkout session for
 * the Diffract subscription (Rs 2,000/mo, LIVE) and returns its checkout_url. The
 * browser is then redirected to Dodo to pay.
 *
 * The live API key is NEVER hard-coded. It is read at runtime from a file named
 * `.diffract-dodo.env` (format: DODO_PAYMENTS_API_KEY=...), which MUST live one
 * level ABOVE public_html so it is not web-accessible. See website/DEPLOY.md.
 */

header('Content-Type: application/json');

const PRODUCT_ID = 'pdt_0NgoqgyAZmJmzhod4sk1f';        // Diffract — Rs 2,000/mo (live)
const DODO_BASE  = 'https://live.dodopayments.com';

// Reserved subdomains — MUST mirror signup.html + local-dev-server.py + the provisioner.
const RESERVED = [
  'app','www','ftp','api','admin','mail','root','ns','ns1','ns2','cdn','static',
  'assets','dashboard','status','blog','support','help','docs','console','portal',
  'login','signup','sign-up','dev','staging','test','demo','mx','smtp','webmail',
  'vpn','git','@',
];

function fail($code, $obj) {
  http_response_code($code);
  echo json_encode($obj);
  exit;
}

function load_dodo_key() {
  $env = getenv('DODO_PAYMENTS_API_KEY');
  if ($env) return trim($env);
  // Preferred: outside public_html. Fallbacks: public_html root, then alongside.
  $candidates = [
    __DIR__ . '/../../.diffract-dodo.env',
    __DIR__ . '/../.diffract-dodo.env',
    __DIR__ . '/.diffract-dodo.env',
  ];
  foreach ($candidates as $p) {
    if (is_readable($p)) {
      foreach (file($p, FILE_IGNORE_NEW_LINES) as $line) {
        $line = trim($line);
        if (strncmp($line, 'DODO_PAYMENTS_API_KEY=', 22) === 0) {
          $v = trim(substr($line, 22));
          if ($v !== '') return $v;
        }
      }
    }
  }
  return null;
}

function slugify($v) {
  $v = strtolower(trim((string)$v));
  $v = preg_replace('/[^a-z0-9-]+/', '-', $v);
  $v = preg_replace('/-+/', '-', $v);
  return trim($v, '-');
}

function valid_workspace($slug) {
  return $slug !== '' && strlen($slug) >= 3 && strlen($slug) <= 30
         && !in_array($slug, RESERVED, true);
}

function valid_email($e) {
  return (bool)preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', (string)$e);
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
  fail(405, ['error' => 'method not allowed']);
}

$raw  = file_get_contents('php://input');
$data = json_decode($raw ?: '{}', true);
if (!is_array($data)) fail(400, ['error' => 'invalid JSON body']);

$workspace = slugify($data['workspace'] ?? '');
$email     = trim((string)($data['email'] ?? ''));
$name      = trim((string)($data['name'] ?? ''));

if (!valid_workspace($workspace)) fail(400, ['error' => 'invalid or reserved workspace name']);
if (!valid_email($email))         fail(400, ['error' => 'invalid email']);

$key = load_dodo_key();
if (!$key) {
  fail(500, ['error' => 'payment backend not configured (missing .diffract-dodo.env)']);
}

$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$host   = $_SERVER['HTTP_HOST'] ?? 'diffraction.in';
$return = $scheme . '://' . $host . '/signup.html?paid=1&ws=' . rawurlencode($workspace);

$payload = json_encode([
  'product_cart' => [['product_id' => PRODUCT_ID, 'quantity' => 1]],
  'return_url'   => $return,
  'metadata'     => ['workspace' => $workspace, 'email' => $email, 'name' => $name],
]);

// POST to Dodo. Prefer the curl extension; fall back to a stream context.
$out = null; $http = 0; $transport_err = null;
if (function_exists('curl_init')) {
  $ch = curl_init(DODO_BASE . '/checkouts');
  curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $key, 'Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 25,
  ]);
  $out  = curl_exec($ch);
  $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  if ($out === false) $transport_err = curl_error($ch);
  curl_close($ch);
} else {
  $ctx = stream_context_create(['http' => [
    'method'        => 'POST',
    'header'        => "Authorization: Bearer $key\r\nContent-Type: application/json\r\n",
    'content'       => $payload,
    'timeout'       => 25,
    'ignore_errors' => true,
  ]]);
  $out = @file_get_contents(DODO_BASE . '/checkouts', false, $ctx);
  if ($out === false) $transport_err = 'stream request failed';
  if (isset($http_response_header[0]) &&
      preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) {
    $http = (int)$m[1];
  }
}

if ($transport_err) fail(502, ['error' => 'request to Dodo failed', 'detail' => $transport_err]);

$resp = json_decode($out ?: '{}', true);
$url  = is_array($resp) ? ($resp['checkout_url'] ?? null) : null;
if (!$url) {
  fail(502, ['error' => 'no checkout_url from Dodo', 'status' => $http, 'raw' => $resp]);
}

echo json_encode(['url' => $url, 'workspace' => $workspace]);
