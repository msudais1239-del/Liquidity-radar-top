export default function handler(request, response) {
  const { password } = request.body

  if (password === process.env.SITE_PASSWORD) {
    response.setHeader('Set-Cookie', `site-auth=${password}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`)
    return response.status(200).json({ success: true })
  }

  return response.status(401).json({ success: false })
}
