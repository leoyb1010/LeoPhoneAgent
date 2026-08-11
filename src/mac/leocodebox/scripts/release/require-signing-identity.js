const identity = String(process.env.LEOCODEBOX_SIGN_IDENTITY || '').trim();

if (!identity) {
  console.error('error: LEOCODEBOX_SIGN_IDENTITY is required for desktop:dist:mac:signed');
  process.exit(1);
}
