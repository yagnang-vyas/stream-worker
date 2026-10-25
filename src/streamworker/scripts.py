"""Lua scripts. Each multi-key state transition is a single atomic script.

Write ordering matters: Redis does not roll back a script that errors part-way (for
example on OOM), so every script performs the write that *creates* the job's new home
before the write that removes its old one. A mid-script failure can then at worst
duplicate a job (allowed by at-least-once delivery), never lose it.
"""

from __future__ import annotations

# KEYS: stream, delayed, [idempotency key]
# ARGV: job_id, maxlen (0 = untrimmed), delay_ms (0 = immediate), idempotency ttl ms,
#       then the job's field/value pairs for XADD.
# The idempotency marker is written last: if anything fails earlier the marker does not
# exist, so a retry of the enqueue cannot be silently swallowed.
ENQUEUE = """
local has_key = #KEYS >= 3
if has_key then
  local existing = redis.call('GET', KEYS[3])
  if existing then
    return existing
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
if has_key then
  redis.call('SET', KEYS[3], ARGV[1], 'PX', ARGV[4])
end
return ARGV[1]
"""

# KEYS: delayed, stream, dead
# ARGV: batch limit, maxlen (0 = untrimmed)
# Each member is added to its destination *before* it is removed from the set.
PROMOTE = """
local function valid(job)
  if type(job) ~= 'table' or next(job) == nil then
    return false
  end
  for k, v in pairs(job) do
    if type(k) ~= 'string' or type(v) ~= 'string' then
      return false
    end
  end
  return true
end
local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local due = redis.call(
  'ZRANGEBYSCORE', KEYS[1], '-inf', string.format('%d', now_ms), 'LIMIT', 0, ARGV[1]
)
for _, member in ipairs(due) do
  local ok, job = pcall(cjson.decode, member)
  if ok and valid(job) then
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
  redis.call('ZREM', KEYS[1], member)
end
return #due
"""

# KEYS: stream, delayed
# ARGV: group, entry id, backoff delay ms, JSON member for the next attempt
# Does nothing unless the entry is still pending, so two consumers racing for one entry
# cannot both reschedule it. The new copy is stored before the old entry is acked.
RETRY = """
if #redis.call('XPENDING', KEYS[1], ARGV[1], ARGV[2], ARGV[2], 1) == 0 then
  return 0
end
local t = redis.call('TIME')
local due = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) + tonumber(ARGV[3])
redis.call('ZADD', KEYS[2], string.format('%d', due), ARGV[4])
redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
redis.call('XDEL', KEYS[1], ARGV[2])
return 1
"""

# KEYS: stream, dead
# ARGV: group, entry id, then field/value pairs for the dead entry
DEAD = """
if #redis.call('XPENDING', KEYS[1], ARGV[1], ARGV[2], ARGV[2], 1) == 0 then
  return 0
end
redis.call('XADD', KEYS[2], '*', unpack(ARGV, 3))
redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
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
