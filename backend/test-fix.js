// 模拟测试：验证 dataProcessor 修复后不完整包不会再触发误告警

// 复刻 dataProcessor.js 中的 parseSensorValue 函数
function parseSensorValue(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : null;
}

// 复刻 alertEngine.js 中的阈值判断逻辑
function checkThresholds(data) {
  const { pondId, temperature, ph, dissolvedOxygen } = data;
  const thresholds = {
    dissolvedOxygen: { critical: 3.0, warning: 4.0 },
    ph: { low: 6.5, high: 9.0 },
    temperature: { high: 35.0 }
  };
  const triggered = [];
  if (dissolvedOxygen !== undefined && dissolvedOxygen !== null) {
    if (dissolvedOxygen < thresholds.dissolvedOxygen.critical) {
      triggered.push({ type: 'low_oxygen', level: 'critical', value: dissolvedOxygen });
    } else if (dissolvedOxygen < thresholds.dissolvedOxygen.warning) {
      triggered.push({ type: 'low_oxygen', level: 'warning', value: dissolvedOxygen });
    }
  }
  if (ph !== undefined && ph !== null) {
    if (ph < thresholds.ph.low) {
      triggered.push({ type: 'low_ph', level: 'critical', value: ph });
    } else if (ph > thresholds.ph.high) {
      triggered.push({ type: 'high_ph', level: 'critical', value: ph });
    }
  }
  if (temperature !== undefined && temperature !== null) {
    if (temperature > thresholds.temperature.high) {
      triggered.push({ type: 'high_temperature', level: 'warning', value: temperature });
    }
  }
  return triggered;
}

// 模拟 MQTT 收到的数据包
function simulatePacket(rawData) {
  const temperatureValue = parseSensorValue(rawData.temperature);
  const phValue = parseSensorValue(rawData.ph);
  const dissolvedOxygenValue = parseSensorValue(rawData.dissolvedOxygen);
  const missingFields = [];
  if (phValue === null) missingFields.push('pH');
  if (dissolvedOxygenValue === null) missingFields.push('溶氧');
  if (temperatureValue === null) missingFields.push('温度');
  return {
    parsed: { pondId: rawData.pondId, temperature: temperatureValue, ph: phValue, dissolvedOxygen: dissolvedOxygenValue },
    missingFields,
    allMissing: missingFields.length === 3,
    alerts: checkThresholds({
      pondId: rawData.pondId,
      temperature: temperatureValue,
      ph: phValue,
      dissolvedOxygen: dissolvedOxygenValue
    })
  };
}

console.log('=== 测试 1: 故障场景 - 仅含 temperature 字段（4G 信号弱的不完整包）===');
const test1 = simulatePacket({ pondId: 'P001', deviceId: 'D001', temperature: 25.5 });
console.log('缺失字段:', test1.missingFields);
console.log('解析后 ph:', test1.parsed.ph, ' 溶氧:', test1.parsed.dissolvedOxygen);
console.log('触发的告警:', test1.alerts);
console.log('期望: 触发的告警为空（不再误报）');
console.log('结果:', test1.alerts.length === 0 ? '✓ 通过' : '✗ 失败');
console.log();

console.log('=== 测试 2: 正常完整包 ===');
const test2 = simulatePacket({ pondId: 'P001', deviceId: 'D001', temperature: 25.5, ph: 7.5, dissolvedOxygen: 6.0 });
console.log('缺失字段:', test2.missingFields);
console.log('触发的告警:', test2.alerts);
console.log('期望: 无告警');
console.log('结果:', test2.alerts.length === 0 ? '✓ 通过' : '✗ 失败');
console.log();

console.log('=== 测试 3: 真正低溶氧场景（应正常告警）===');
const test3 = simulatePacket({ pondId: 'P001', deviceId: 'D001', temperature: 25.5, ph: 7.5, dissolvedOxygen: 2.5 });
console.log('触发的告警:', test3.alerts);
console.log('期望: low_oxygen critical');
console.log('结果:', (test3.alerts.length === 1 && test3.alerts[0].type === 'low_oxygen' && test3.alerts[0].level === 'critical') ? '✓ 通过' : '✗ 失败');
console.log();

console.log('=== 测试 4: 真正低 pH 场景（应正常告警）===');
const test4 = simulatePacket({ pondId: 'P001', deviceId: 'D001', temperature: 25.5, ph: 5.5, dissolvedOxygen: 6.0 });
console.log('触发的告警:', test4.alerts);
console.log('期望: low_ph critical');
console.log('结果:', (test4.alerts.length === 1 && test4.alerts[0].type === 'low_ph' && test4.alerts[0].level === 'critical') ? '✓ 通过' : '✗ 失败');
console.log();

console.log('=== 测试 5: 三个字段全部缺失（应判定为无效包）===');
const test5 = simulatePacket({ pondId: 'P001', deviceId: 'D001' });
console.log('缺失字段:', test5.missingFields);
console.log('是否全部缺失:', test5.allMissing);
console.log('触发的告警:', test5.alerts);
console.log('期望: allMissing=true 且 触发的告警为空');
console.log('结果:', (test5.allMissing && test5.alerts.length === 0) ? '✓ 通过' : '✗ 失败');
console.log();

console.log('=== 测试 6: 非法字符串值（应视为 null）===');
const test6 = simulatePacket({ pondId: 'P001', deviceId: 'D001', temperature: 'abc', ph: '7.5', dissolvedOxygen: '6.0' });
console.log('解析后 temperature:', test6.parsed.temperature);
console.log('触发的告警:', test6.alerts);
console.log('期望: temperature=null 不参与告警判断（与未传一致）');
console.log('结果:', test6.parsed.temperature === null ? '✓ 通过' : '✗ 失败');
console.log();

console.log('=== 测试 7: 老代码行为对比 - 验证 bug 真实存在 ===');
function oldParseAndCheck(data) {
  const ph = parseFloat(data.ph) || 0;
  const dissolvedOxygen = parseFloat(data.dissolvedOxygen) || 0;
  return checkThresholds({ pondId: data.pondId, ph, dissolvedOxygen });
}
const oldResult = oldParseAndCheck({ pondId: 'P001', temperature: 25.5 });
console.log('老代码在不完整包下的告警:', oldResult);
console.log('确认 bug: 老代码会误触发 critical 告警', oldResult.length > 0 ? '✓ 复现成功' : '未复现');
