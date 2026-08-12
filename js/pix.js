(function (root) {
  function tlv(id, value) {
    var len = String(value.length).padStart(2, '0');
    return id + len + value;
  }

  function crc16(str) {
    var crc = 0xFFFF;
    for (var i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (var j = 0; j < 8; j++) {
        if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
        else crc = (crc << 1) & 0xFFFF;
      }
    }
    return ('0000' + crc.toString(16).toUpperCase()).slice(-4);
  }

  function buildPixPayload(opts) {
    var chave = String(opts.chave || '');
    var nome = String(opts.nome || '').substring(0, 25);
    var cidade = String(opts.cidade || '').substring(0, 15);
    var txid = String(opts.txid || '***').substring(0, 25);
    var amount = Number(opts.valor).toFixed(2);
    var merchant = tlv('00', 'BR.GOV.BCB.PIX') + tlv('01', chave);
    var additional = tlv('05', txid);
    var payload = tlv('00', '01')
      + tlv('26', merchant)
      + '52040000'
      + '5303986'
      + tlv('54', amount)
      + '5802BR'
      + tlv('59', nome)
      + tlv('60', cidade)
      + tlv('62', additional)
      + '6304';
    return payload + crc16(payload);
  }

  root.buildPixPayload = buildPixPayload;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildPixPayload: buildPixPayload, crc16: crc16, tlv: tlv };
  }
})(typeof window !== 'undefined' ? window : global);
