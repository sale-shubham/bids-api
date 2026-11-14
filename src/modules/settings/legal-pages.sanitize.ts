import sanitizeHtml from 'sanitize-html';

// Server-side allow-list for legal page HTML (same approach as the auction
// description sanitiser, plus a few block/inline tags legal text needs).
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote', 'a'],
  allowedAttributes: { a: ['href', 'rel', 'target'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'noopener noreferrer nofollow', target: '_blank' } }),
  },
};

export function sanitizeLegalHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS).trim();
}
