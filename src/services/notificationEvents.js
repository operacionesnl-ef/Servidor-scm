'use strict';

const { EventEmitter } = require('node:events');

const events = new EventEmitter();
events.setMaxListeners(0);
let publishPending = false;

function publishNotificationChange() {
  if (publishPending) return;
  publishPending = true;
  const timer = setTimeout(() => {
    publishPending = false;
    events.emit('change');
  }, 1000);
  timer.unref?.();
}

function subscribeToNotificationChanges(listener) {
  events.on('change', listener);
  return () => events.off('change', listener);
}

module.exports = { publishNotificationChange, subscribeToNotificationChanges };
