import sys

def patch(path, before, after, label, already_marker):
    with open(path, encoding='utf-8') as f:
        c = f.read()
    if before not in c:
        if already_marker in c:
            print('✅ ' + label + ': مطبّق مسبقاً')
        else:
            print('❌ ' + label + ': ما لقيت نقطة الإدراج — ابعت محتوى المكان المتوقع')
            sys.exit(1)
        return
    c = c.replace(before, after, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(c)
    print('✅ ' + label + ': تم')

before = """    const info = {};
    state.nextEpoch(session);
    const cardMsg = await safeSend(session.chatId, roundCardText(session, asker, answerer, info), { reply_markup: kb.choiceKeyboard(session) });
    const cardId = cardMsg?.message_id;

"""
after = """    const info = {};
    state.nextEpoch(session);
    const cardMsg = await safeSend(session.chatId, roundCardText(session, asker, answerer, info), { reply_markup: kb.choiceKeyboard(session) });
    if (!cardMsg) {
      logger.warn('[ToD] تعذّر الإرسال للقروب — إنهاء الجلسة: ' + session.chatId);
      await endSession(session, 'تعذّر إرسال رسائل لهذا القروب (البوت رُبما أُزيل منه).');
      return;
    }
    const cardId = cardMsg?.message_id;

"""
patch('handlers/tod/engine.js', before, after, 'handlers/tod/engine.js (وقف حلقة الإرسال اللانهائية)', already_marker="تعذّر الإرسال للقروب")
print('')
print('✅ خلصت')
