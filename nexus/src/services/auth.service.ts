import { UserModel } from '../models/user.model';
import { verifyPassword } from '../utils/crypto';
import { signToken, JwtPayload } from '../utils/jwt';

export class AuthService {
  static async login(username: string, password: string) {
    const user = UserModel.findByUsername(username);
    if (!user) {
      throw new Error('Invalid credentials');
    }

    const isValid = verifyPassword(password, user.password_hash, user.salt);
    if (!isValid) {
      throw new Error('Invalid credentials');
    }

    const payload: JwtPayload = {
      userId: user.id,
      username: user.username,
      isAdmin: user.is_admin === 1
    };

    return { token: signToken(payload), user: payload };
  }

  static async register(username: string, password: string) {
    if (UserModel.findByUsername(username)) {
      throw new Error('Username already exists');
    }
    
    const isFirstUser = UserModel.findById(1) === undefined;
    const user = UserModel.create(username, password, isFirstUser);
    
    const payload: JwtPayload = {
      userId: user.id,
      username: user.username,
      isAdmin: user.is_admin === 1
    };
    
    return { token: signToken(payload), user: payload };
  }
}
