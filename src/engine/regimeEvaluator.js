function clampScore(value) {
  return Math.max(0, Math.min(100, value));
}

function evaluateRegime(flags = {}) {
  const normalized = {
    hasMacroEvent: Boolean(flags.hasMacroEvent),
    hasVolumeSpike: Boolean(flags.hasVolumeSpike),
    hasVixGap: Boolean(flags.hasVixGap),
    hasAtrExpansion: Boolean(flags.hasAtrExpansion)
  };

  let score = 100;
  const reasons = [];

  if (normalized.hasMacroEvent) {
    score -= 40;
    reasons.push('重大事件日');
  }
  if (normalized.hasVolumeSpike) {
    score -= 20;
    reasons.push('开盘成交量异常');
  }
  if (normalized.hasVixGap) {
    score -= 20;
    reasons.push('VIX 跳空');
  }
  if (normalized.hasAtrExpansion) {
    score -= 20;
    reasons.push('波动异常扩张');
  }

  const dealerInfluence = clampScore(score);
  let regime = 'flow_dominated';
  let referenceLevel = '低';
  let message = '引力位仅作观察。';

  if (dealerInfluence >= 80) {
    regime = 'dealer_dominated';
    referenceLevel = '高';
    message = '当前引力位参考性较高。';
  } else if (dealerInfluence >= 50) {
    regime = 'mixed';
    referenceLevel = '中';
    message = '引力位可参考，但需要观察确认。';
  } else if (dealerInfluence >= 20) {
    regime = 'flow_dominated';
    referenceLevel = '低';
    message = '主动资金影响较强，引力位可能失效。';
  }

  if (normalized.hasMacroEvent) {
    message = '重大事件前后，引力位可能快速失效。';
  }

  return {
    dealerInfluence,
    regime,
    referenceLevel,
    message,
    reasons,
    flags: normalized
  };
}

module.exports = {
  evaluateRegime
};
