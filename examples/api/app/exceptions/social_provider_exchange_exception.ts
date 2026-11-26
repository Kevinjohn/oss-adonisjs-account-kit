import { Exception } from '@adonisjs/core/exceptions'

export default class SocialProviderExchangeException extends Exception {
  static status = 502
  static code = 'E_SOCIAL_PROVIDER_EXCHANGE'
  static message = 'Social provider exchange failed'

  constructor(readonly category: 'denied' | 'missing_code' | 'unavailable' | 'provider_mismatch') {
    super(SocialProviderExchangeException.message)
  }
}
