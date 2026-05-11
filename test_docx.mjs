import mammoth from 'mammoth';
import fs from 'fs';

// 创建一个简单的测试 docx 文件
console.log('测试 mammoth 模块加载...');

try {
  // 检查 mammoth 是否可用
  const result = mammoth.extractRawText({arrayBuffer: Buffer.alloc(0)});
  console.log('mammoth 模块可用');
} catch (e) {
  console.log('mammoth 错误:', e.message);
}

// 检查 mammoth 模块是否存在
try {
  const mammothPath = require.resolve('mammoth');
  console.log('mammoth 路径:', mammothPath);
} catch (e) {
  console.log('mammoth 未安装');
}

console.log('测试完成');
