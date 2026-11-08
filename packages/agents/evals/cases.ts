import { MemoryStore } from "../src/testing/memory-store";

// What owners actually say, in the languages Munshi hears, each with the tool it must lead to.
// "expect: []" means no change may be made (chit-chat). Wording follows real chats from testing.

export type EvalCase = { text: string; expect: string[] };

export const WRITE_TOOLS = new Set(["recordCredit", "recordPayment", "recordSale", "addCustomer", "updateStock", "sendPaymentLink", "showPaymentQr", "remember", "forget"]);

export const CASES: EvalCase[] = [
  // The khata: udhaar, payments, sales, balances
  { text: "Ramesh ne 450 ka saaman liya", expect: ["recordCredit"] },
  { text: "Fatima ne 200 cash diye", expect: ["recordPayment"] },
  { text: "Ramesh avru 300 rupayi saaman togondru", expect: ["recordCredit"] },
  { text: "Fatima 100 rupayi kottru", expect: ["recordPayment"] },
  { text: "रमेश ने 150 रुपये दिए", expect: ["recordPayment"] },
  { text: "Aaj 1200 ki bikri hui", expect: ["recordSale"] },
  { text: "Bijli ka bill 800 bhara", expect: ["recordSale"] },
  { text: "Kitna udhaar baaki hai sabka?", expect: ["getBalances"] },
  { text: "Ramesh evvalavu baaki irukku?", expect: ["getBalances"] },
  { text: "How much does Fatima owe?", expect: ["getBalances"] },
  { text: "Naya customer add karo, Suresh, number 9876543210", expect: ["addCustomer"] },
  // Collections: links, QRs, checking payments, habits
  { text: "Ramesh ko payment link bhejo", expect: ["sendPaymentLink"] },
  { text: "Send Ramesh a link to pay his dues", expect: ["sendPaymentLink"] },
  { text: "Fatima ka QR dikhao", expect: ["showPaymentQr"] },
  { text: "Ramesh ka payment aaya?", expect: ["checkPayment"] },
  { text: "Did Fatima pay online?", expect: ["checkPayment"] },
  { text: "Fatima usually kab payment karti hai?", expect: ["paymentHabits"] },
  // Stock
  { text: "Chawal kitna bacha hai?", expect: ["getStock"] },
  { text: "Akki eshtu ide?", expect: ["getStock"] },
  { text: "Kaunsa saaman khatam hone wala hai?", expect: ["getStock"] },
  { text: "10 packet Maggi aaya", expect: ["updateStock"] },
  { text: "Sugar 5 kg bik gaya", expect: ["updateStock"] },
  // Memory
  { text: "Yaad rakhna, Fatima Sunday ko dukaan nahi aati", expect: ["remember"] },
  { text: "Ramesh ke baare mein kya yaad hai?", expect: ["recall"] },
  // Chit-chat: nothing may change
  { text: "Namaste", expect: [] },
  { text: "Thank you bhai", expect: [] },
  // Two things at once
  { text: "Ramesh ne 200 diye, ab kitna baaki hai?", expect: ["recordPayment"] },

  // Held out: written after the desks were first tuned, so they test it rather than fit it.
  { text: "Lakshmi ne 650 ka udhaar liya", expect: ["recordCredit"] },
  { text: "Ramesh paid 300 in cash today", expect: ["recordPayment"] },
  { text: "ಫಾತಿಮಾ 50 ರೂಪಾಯಿ ಕೊಟ್ಟರು", expect: ["recordPayment"] },
  { text: "Doodh wale ko 1500 diye", expect: ["recordSale"] },
  { text: "Sabse zyada udhaar kiska hai?", expect: ["getBalances"] },
  { text: "Ramesh ka phone number kya hai?", expect: ["findCustomer"] },
  { text: "Fatima ko 230 ka link bhej do", expect: ["sendPaymentLink"] },
  { text: "Ramesh ko QR scan karna hai", expect: ["showPaymentQr"] },
  { text: "Has Ramesh paid the link yet?", expect: ["checkPayment"] },
  { text: "Maggi kitne packet hai?", expect: ["getStock"] },
  { text: "5 kg chawal aur aaya", expect: ["updateStock"] },
  { text: "Shukriya", expect: [] },
];

/** Index of the first held-out case, for scoring them apart. */
export const HELD_OUT_FROM = 27;

/** A small shop with some history, fresh for every case so no case sees another's changes. */
export async function seededStore() {
  const store = new MemoryStore();
  const ramesh = await store.addCustomer({ name: "Ramesh", phone: "+919800000001" });
  const fatima = await store.addCustomer({ name: "Fatima", phone: "+919800000002" });
  await store.addCustomer({ name: "Lakshmi" });
  await store.addLedgerEntry({ kind: "credit_given", amountPaise: 45000, customerId: ramesh.id });
  await store.addLedgerEntry({ kind: "credit_given", amountPaise: 50000, customerId: fatima.id });
  await store.addLedgerEntry({ kind: "payment_received", amountPaise: 27000, customerId: fatima.id });
  store.products.push(
    { id: "prd_rice", name: "Rice", aliases: ["chawal", "akki", "arisi", "चावल"], unit: "kg", stockQty: 50, reorderLevel: 10, pricePaise: 6000 },
    { id: "prd_maggi", name: "Maggi", aliases: [], unit: "packet", stockQty: 12, reorderLevel: 10, pricePaise: 1400 },
    { id: "prd_sugar", name: "Sugar", aliases: ["cheeni", "sakkare"], unit: "kg", stockQty: 3, reorderLevel: 5, pricePaise: 4500 },
  );
  await store.remember({ fact: "Ramesh is the husband of Lakshmi, the owner's neighbour.", customerId: ramesh.id });
  // The history is from earlier in the week, not seconds ago: the tools treat an identical entry
  // from the last few minutes as a possible repeat.
  store.entries.forEach((entry, i) => (entry.createdAt = new Date(Date.now() - (5 - i) * 24 * 60 * 60 * 1000).toISOString()));
  return store;
}
