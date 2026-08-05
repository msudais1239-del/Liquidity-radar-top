export default function middleware(request) {
  const authCookie = request.headers.get('cookie')?.includes(`site-auth=${process.env.SITE_PASSWORD}`)

  if (authCookie) {
    return new Response(null, { status: 200 })
  }

  const url = new URL(request.url)
  if (url.pathname === '/api/auth' || url.pathname === '/login.html') {
    return new Response(null, { status: 200 })
  }

  return Response.redirect(new URL('/login.html', request.url))
}

export const config = {
  matcher: '/((?!api/auth|login.html|_vercel|assets).*)',
}
