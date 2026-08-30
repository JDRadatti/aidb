// THsi is a comment
#include <iostream>

int add(int x, int y);

int getValueFromUser() {
  int x = 0;
  std::cin >> x;
  return x;
}

int doubleInteger(int i) { return i * 2; }

int main(void) {
  // //    int lets_do;
  //     lets_do = 10;
  //     float f = 10.0;
  //     printf("float %f, lets_do %d", f, lets_do);
  //
  //     int total = 0;
  //     for (int i = 0; i < 10; i++)
  //     {
  //         total += i;
  //     }
  //     return 0;

  // get input
  // double input
  // check diff between ++x x++ and x += 1
  int input = getValueFromUser();
  int doubledInput = doubleInteger(input);
  std::cout << "Doubled input: " << doubledInput << "\n";

  int b = ++input;
  int c = input++;
  int d = input += 1;
  int e = add(input, 100);

  std::cout << b << "\n";
  std::cout << c << "\n";
  std::cout << d << "\n"; 
  std::cout << e << "\n";

  return 0;
}
