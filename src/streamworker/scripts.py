"""Lua scripts. Each multi-key state transition is a single atomic script."""

from __future__ import annotations

# KEYS: stream, delayed, [idempotency key]
# ARGV: job_id, maxlen (0 = untrimmed), delay_ms (0 = immediate), idempotency ttl ms,
#       then the job's field/value pairs for XADD.
ENQUEUE = """
if #KEYS >= 3 then
  local created = redis.call('SET', KEYS[3], ARGV[1], 'NX', 'PX', ARGV[4])
  if not created then
    return redis.call('GET', KEYS[3])
  end
end
local delay = tonumber(ARGV[3])
if delay > 0 then
  local t = redis.call('TIME')
  local due = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) + delay
  local fields = {}
  for i = 5, #ARGV, 2 do
    fields[ARGV[i]] = ARGV[i + 1]
  end
  redis.call('ZADD', KEYS[2], string.format('%d', due), cjson.encode(fields))
elseif tonumber(ARGV[2]) > 0 then
  redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[2], '*', unpack(ARGV, 5))
else
  redis.call('XADD', KEYS[1], '*', unpack(ARGV, 5))
end
return ARGV[1]
"""

# KEYS: delayed, stream, dead
# ARGV: batch limit, maxlen (0 = untrimmed), failed_at is taken from server TIME
PROMOTE = """
local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local due = redis.call(
  'ZRANGEBYSCORE', KEYS[1], '-inf', string.format('%d', now_ms), 'LIMIT', 0, ARGV[1]
)
for _, member in ipairs(due) do
  redis.call('ZREM', KEYS[1], member)
  local ok, job = pcall(cjson.decode, member)
  if ok and type(job) == 'table' then
    local args = {}
    for k, v in pairs(job) do
      args[#args + 1] = k
      args[#args + 1] = v
    end
    if tonumber(ARGV[2]) > 0 then
      redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*', unpack(args))
    else
      redis.call('XADD', KEYS[2], '*', unpack(args))
    end
  else
    redis.call('XADD', KEYS[3], '*',
      'payload', member,
      'error_type', 'MalformedJob',
      'error_message', 'undecodable delayed member',
      'failed_at', string.format('%d', now_ms))
  end
end
return #due
"""

# KEYS: stream, delayed
# ARGV: group, entry id, backoff delay ms, JSON member for the next attempt
RETRY = """
if redis.call('XACK', KEYS[1], ARGV[1], ARGV[2]) == 0 then
  return 0
end
local t = redis.call('TIME')
local due = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) + tonumber(ARGV[3])
redis.call('ZADD', KEYS[2], string.format('%d', due), ARGV[4])
redis.call('XDEL', KEYS[1], ARGV[2])
return 1
"""

# KEYS: stream, dead
# ARGV: group, entry id, then field/value pairs for the dead entry
DEAD = """
if redis.call('XACK', KEYS[1], ARGV[1], ARGV[2]) == 0 then
  return 0
end
redis.call('XADD', KEYS[2], '*', unpack(ARGV, 3))
redis.call('XDEL', KEYS[1], ARGV[2])
return 1
"""

# KEYS: dead, stream
# ARGV: dead entry id, maxlen (0 = untrimmed)
REQUEUE = """
local res = redis.call('XRANGE', KEYS[1], ARGV[1], ARGV[1])
if #res == 0 then
  return false
end
local f = res[1][2]
local args = {}
for i = 1, #f, 2 do
  local k, v = f[i], f[i + 1]
  if k == 'attempt' then
    v = '1'
  end
  if k ~= 'error_type' and k ~= 'error_message' and k ~= 'failed_at' then
    args[#args + 1] = k
    args[#args + 1] = v
  end
end
local new_id
if tonumber(ARGV[2]) > 0 then
  new_id = redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*', unpack(args))
else
  new_id = redis.call('XADD', KEYS[2], '*', unpack(args))
end
redis.call('XDEL', KEYS[1], ARGV[1])
return new_id
"""
