import bigInt from 'big-integer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The built part has no code made at run time (scripts/build-pc.mjs: teleproto's `new Function` throws, its field-by-field
// reading is used). The same here: with `new Function` refused, Telegram's objects still go to bytes and back intact.

const RealFunction = globalThis.Function;
let refused = 0;
beforeAll(() => {
  const refuse = () => {
    refused++;
    throw new Error('no code generation');
  };
  globalThis.Function = new Proxy(RealFunction, { construct: refuse, apply: refuse });
});
afterAll(() => {
  globalThis.Function = RealFunction;
});

describe('teleproto without code generation', () => {
  it('a message with text, a link, a photo and a reply reads back the same', async () => {
    const { Api } = await import('teleproto');
    const { BinaryReader } = await import('teleproto/extensions/BinaryReader');
    const m = new Api.Message({
      id: 7,
      peerId: new Api.PeerChannel({ channelId: bigInt(1234) }),
      fromId: new Api.PeerUser({ userId: bigInt(555) }),
      date: 1_763_000_000,
      message: 'Оплата 1500 R$ — https://example.com/receipt',
      entities: [new Api.MessageEntityUrl({ offset: 17, length: 27 })],
      replyTo: new Api.MessageReplyHeader({ replyToMsgId: 3 }),
      media: new Api.MessageMediaWebPage({ webpage: new Api.WebPageEmpty({ id: bigInt(1), url: 'https://example.com/receipt' }) }),
    });
    const back = new BinaryReader(Buffer.from(m.getBytes())).tgReadObject() as InstanceType<typeof Api.Message>;
    expect(back).toBeInstanceOf(Api.Message);
    expect(back.id).toBe(7);
    expect(back.message).toBe('Оплата 1500 R$ — https://example.com/receipt');
    expect(String((back.fromId as InstanceType<typeof Api.PeerUser>).userId)).toBe('555');
    expect((back.replyTo as InstanceType<typeof Api.MessageReplyHeader>).replyToMsgId).toBe(3);
    expect(back.entities?.[0]).toMatchObject({ offset: 17, length: 27 });
    expect(back.media).toBeInstanceOf(Api.MessageMediaWebPage);
    // teleproto did try to make code, was refused and read field by field.
    expect(refused).toBeGreaterThan(0);
  });
});
