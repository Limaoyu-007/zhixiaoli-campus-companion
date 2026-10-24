// Internal UI contract only. This does not infer business results from reply text.
window.CampusFeedback = {
  describe(value) {
    if (!value || typeof value !== 'object') return null;
    // Transport uncertainty never proves a booking failed or succeeded.
    if (value.source === 'transport' && value.status === 'uncertain') {
      return { status: 'uncertain', operation: 'unknown', label: '结果待确认' };
    }
    if (value.source !== 'tool' ||
        !['success', 'failed', 'partial', 'uncertain'].includes(value.status) ||
        !['booking', 'cancel', 'mixed'].includes(value.operation)) return null;
    const noun = { booking: '预约', cancel: '取消', mixed: '操作' }[value.operation];
    const label = {
      success: `${noun}完成`, failed: `${noun}未完成`,
      partial: '部分完成', uncertain: '结果待确认',
    }[value.status];
    return { status: value.status, operation: value.operation, label };
  },
};
