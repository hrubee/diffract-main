<?php
/**
 * Diffract — post-payment workspace claim (Hostinger shared LiteSpeed / PHP).
 *
 * AUDIT FALLBACK (provisioning is now automated by the control-plane webhook).
 * Name-before-pay flow: the customer picks a workspace, pays on Dodo (the name
 * rides in the Dodo metadata), and the control plane provisions automatically on
 * the subscription.active webhook. On return to signup.html?paid=1 the page also
 * POSTs here, best-effort, to append {workspace, email, raw Dodo return params,
 * time, IP} as one JSON line ONE LEVEL ABOVE public_html (not web-accessible) —
 * a human-readable reconciliation trail against the Dodo dashboard and the
 * control-plane tenant registry. It does NOT itself provision anything.
 */

header('Content-Type: application/json');

// Reserved subdomains — MUST mirror signup.html + checkout.php + the provisioner.
const RESERVED = [
  'app','www','ftp','api','admin','mail','root','ns','ns1','ns2','cdn','static',
  'assets','dashboard','status','blog','support','help','docs','console','portal',
  'login','signup','sign-up','dev','staging','test','demo','mx','smtp','webmail',
  'vpn','git','@',
];

// Log file name. Written one level ABOVE public_html (alongside .diffract-dodo.env),
// so it is never web-accessible. (The .htaccess also denies *.log as defense in depth.)
const LOG_NAME = 'diffract-signups.log';

function fail($code, $obj) {
  http_response_code($code);
  echo json_encode($obj);
  exit;
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
  return (bool) preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', (string)$e);
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
  fail(405, ['error' => 'method not allowed']);
}

$raw  = file_get_contents('php://input');
$data = json_decode($raw ?: '{}', true);
if (!is_array($data)) fail(400, ['error' => 'invalid JSON body']);

$workspace = slugify($data['workspace'] ?? '');
$email     = trim((string)($data['email'] ?? ''));
$ref       = trim((string)($data['ref'] ?? ''));   // raw Dodo return query string

if (!valid_workspace($workspace)) fail(400, ['error' => 'invalid or reserved workspace name']);
if (!valid_email($email))         fail(400, ['error' => 'invalid email']);
if (strlen($ref) > 2000) $ref = substr($ref, 0, 2000);   // defensive cap

$rec = [
  'ts'        => gmdate('c'),
  'workspace' => $workspace,
  'email'     => $email,
  'dodo_ref'  => $ref,
  'ip'        => $_SERVER['REMOTE_ADDR'] ?? '',
  'ua'        => substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 300),
];
$line = json_encode($rec, JSON_UNESCAPED_SLASHES) . "\n";

// Primary: one level above public_html (same dir as .diffract-dodo.env — writable
// by the PHP user, not web-served). Fallback: the system temp dir (also private).
// Never write inside public_html, so the log of emails/refs can't be served.
$primary  = __DIR__ . '/../../' . LOG_NAME;
$fallback = rtrim(sys_get_temp_dir(), '/') . '/' . LOG_NAME;

$ok = @file_put_contents($primary, $line, FILE_APPEND | LOCK_EX);
if ($ok === false) {
  $ok = @file_put_contents($fallback, $line, FILE_APPEND | LOCK_EX);
}
if ($ok === false) {
  fail(500, ['error' => 'could not record signup — please email support with your workspace name']);
}

echo json_encode([
  'ok'        => true,
  'workspace' => $workspace,
  'url'       => 'https://' . $workspace . '.diffraction.in',
]);
