export default function middleware(request) {
  const url = new URL(request.url)

  if (url.pathname === '/login.html' || url.pathname === '/api/auth') {
    return
  }

  const cookie = request.headers.get('cookie') || ''
  const isAuthed = cookie.includes(`site-auth=${process.env.SITE_PASSWORD}`)

  if (isAuthed) {
    return
  }

  return Response.redirect(new URL('/login.html', request.url))
}

export const config = {
  matcher: '/((?!api/auth|login.html|_vercel|assets).*)',
}
