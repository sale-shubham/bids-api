// Draft legal text for NobleBid, inserted by prisma/seed.ts ONLY when a page has no content yet
// (an admin-edited page is never overwritten). HTML limited to the legal-page allow-list.
// These are drafts, not legal advice.

const DRAFT =
  '<blockquote><p><strong>Draft — have this reviewed by a lawyer before launch.</strong></p></blockquote>';

export const LEGAL_SEED: { slug: string; title: string; content: string }[] = [
  {
    slug: 'terms-conditions',
    title: 'Terms and Conditions',
    content: `${DRAFT}
<h2>1. About NobleBid</h2>
<p>NobleBid is an online auction platform that lets registered members list items for auction and bid on items listed by others. NobleBid provides the platform only. Unless stated otherwise, NobleBid is not the seller of any item and is not a party to the sale between a seller and the winning bidder.</p>
<h2>2. Eligibility and accounts</h2>
<ul>
<li>You must be at least 18 years old and capable of entering into a binding contract under the Indian Contract Act, 1872.</li>
<li>You must provide accurate information, verify your email address and keep your password confidential. You are responsible for all activity under your account.</li>
<li>We may suspend or close an account that breaches these terms or is used for fraud or abuse.</li>
</ul>
<h2>3. Bidder obligations</h2>
<ul>
<li>A bid is a binding offer to buy the item at the bid amount. Bids cannot be withdrawn once placed.</li>
<li>The highest valid bid at the close of the auction wins. If you win, you must complete the purchase with the seller and pay the seller the winning amount, using the contact details shared after the auction ends.</li>
<li>You must not place bids you do not intend to honour, manipulate bidding (including bidding on your own listings, or through multiple accounts), or interfere with the platform.</li>
<li>To protect against last-minute sniping, an auction may be automatically extended when a bid is placed close to its end time.</li>
</ul>
<h2>4. Seller obligations</h2>
<ul>
<li>You must be the lawful owner of, or authorised to sell, every item you list, and describe it accurately and honestly, including its condition.</li>
<li>You must not list prohibited, counterfeit, stolen or illegal items.</li>
<li>Once an auction has received a bid it cannot be edited. You must sell the item to the winning bidder at the winning amount.</li>
</ul>
<h2>5. Seller commission</h2>
<p>NobleBid charges the seller a commission of <strong>5%</strong> of the final winning bid on every item that sells. The rate in force when an auction closes applies to that auction. The commission is shown to the seller when the auction ends and is payable online through Razorpay. A seller with an unpaid commission may be prevented from listing new auctions until it is paid. NobleBid may, at its discretion, waive a commission. There is no fee for bidders.</p>
<h2>6. Payments</h2>
<p>Commission payments are processed by Razorpay, a third-party payment gateway, and are subject to its terms. NobleBid does not store your card or bank details. Payment of the winning bid for an item is made directly between the winning bidder and the seller, outside the platform.</p>
<h2>7. Disputes between members</h2>
<p>Because the sale contract is between the seller and the winning bidder, any dispute about an item, its delivery or payment must be resolved between them. NobleBid may, but is not obliged to, help and may remove listings or suspend accounts in response to reports.</p>
<h2>8. Prohibited conduct</h2>
<p>You must not use NobleBid to break any law, infringe anyone's rights, post misleading or abusive content, scrape the platform, or attempt to disrupt or gain unauthorised access to it.</p>
<h2>9. Limitation of liability</h2>
<p>To the extent permitted by law, NobleBid is provided on an "as is" basis and is not liable for indirect or consequential loss, or for the quality, safety, legality or delivery of items listed by members. Nothing in these terms excludes liability that cannot be excluded under applicable law.</p>
<h2>10. Governing law and jurisdiction</h2>
<p>These terms are governed by the laws of India. Subject to applicable law, the courts at [city to be confirmed] have exclusive jurisdiction.</p>
<h2>11. Changes and contact</h2>
<p>We may update these terms from time to time; continued use of NobleBid after an update means you accept it. Questions can be sent through our Contact page.</p>`,
  },
  {
    slug: 'privacy-policy',
    title: 'Privacy Policy',
    content: `${DRAFT}
<h2>1. Who we are</h2>
<p>NobleBid ("we", "us") operates an online auction platform. For the purposes of the Digital Personal Data Protection Act, 2023 ("DPDP Act"), we act as the data fiduciary for the personal data described below.</p>
<h2>2. Data we collect</h2>
<ul>
<li><strong>Account data:</strong> name, email address, password (stored only as a one-way hash), optional phone number, address and profile picture.</li>
<li><strong>Activity data:</strong> auctions you list, bids you place, items you watch, commissions and payment status.</li>
<li><strong>Technical data:</strong> IP address, browser and device information, and the session cookies needed to keep you signed in.</li>
<li><strong>Communications:</strong> messages you send us through the Contact form.</li>
</ul>
<h2>3. Why we use it</h2>
<p>We process your personal data with your consent, or for the legitimate uses recognised by the DPDP Act, to:</p>
<ul>
<li>create and secure your account and verify your email;</li>
<li>run auctions, record bids, determine winners and put winners and sellers in touch with each other;</li>
<li>send service notifications (outbid, won, sold, ending soon, commission reminders) by email, in-app and, if you allow it, browser push;</li>
<li>charge and record seller commissions, and prevent fraud and abuse;</li>
<li>comply with applicable law.</li>
</ul>
<h2>4. What other members can see</h2>
<p>Bidders are shown in bid histories with a masked name. A leaderboard shows only your first name and last initial. When an auction ends, the winner and the seller are shown each other's name, email address and phone number (if provided) so that they can complete the sale.</p>
<h2>5. Sharing</h2>
<p>We do not sell your personal data. We share it only with service providers that help us run NobleBid, such as cloud hosting and email delivery (AWS) and payment processing (Razorpay), and where required by law. Payment card and bank details are handled by Razorpay and are not stored by us.</p>
<h2>6. Retention</h2>
<p>We keep your data while your account is active and for as long as needed for the purposes above, including to keep auction and commission records. Expired verification codes, inactive sessions and similar technical records are deleted automatically on a regular schedule.</p>
<h2>7. Your rights under the DPDP Act</h2>
<ul>
<li>access a summary of your personal data and how it is processed;</li>
<li>correct or update inaccurate data (most of it from your profile page);</li>
<li>request erasure of your data, subject to records we must keep by law;</li>
<li>withdraw consent, and nominate another person to exercise your rights in the event of your death or incapacity;</li>
<li>make a grievance to us and, if unresolved, to the Data Protection Board of India.</li>
</ul>
<p>To exercise these rights, contact us through our Contact page.</p>
<h2>8. Security</h2>
<p>We use reasonable safeguards including encrypted connections, hashed passwords and access controls. No system is completely secure, and we will notify affected users and the authorities of a personal data breach as required by law.</p>
<h2>9. Children</h2>
<p>NobleBid is not intended for anyone under 18, and we do not knowingly collect personal data of children.</p>
<h2>10. Changes</h2>
<p>We may update this policy; the latest version is always on this page.</p>`,
  },
  {
    slug: 'refund-policy',
    title: 'Refund Policy',
    content: `${DRAFT}
<h2>1. What this policy covers</h2>
<p>NobleBid charges money to sellers only: a commission of <strong>5%</strong> of the final winning bid for each item that sells, paid online through Razorpay. Bidders pay NobleBid nothing; the winning amount is paid directly by the bidder to the seller outside the platform.</p>
<h2>2. Commission refunds</h2>
<ul>
<li>A commission is earned when an auction closes with a winning bid.</li>
<li>If a commission was charged in error (for example, a duplicate payment or an incorrect amount), tell us through the Contact page with the payment reference and we will refund the difference.</li>
<li>If a sale does not go through because of a dispute between the seller and the buyer, the commission is generally not refundable, but we may review exceptional cases at our discretion and may waive or refund the commission.</li>
</ul>
<h2>3. Failed or duplicate payments</h2>
<p>If money was debited but the commission still shows as due, wait a few minutes for the payment to be confirmed. If it is still unresolved, contact us with the Razorpay payment ID. Amounts debited in error are returned to the original payment method.</p>
<h2>4. Refund timelines</h2>
<p>Approved refunds are initiated within 7 working days and then take the time your bank or card issuer needs, typically 5 to 10 working days.</p>
<h2>5. Items bought through auctions</h2>
<p>Items are sold by individual sellers, not by NobleBid, so returns and refunds for an item are a matter between the winning bidder and the seller. Please check an item's description and ask the seller questions before bidding, because bids are binding.</p>
<h2>6. Contact</h2>
<p>For any refund request, use our Contact page.</p>`,
  },
];
